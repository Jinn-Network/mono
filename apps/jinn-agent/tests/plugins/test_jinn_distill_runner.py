"""Background distillation runner (mono #1539).

A run takes minutes (one frontier call per cluster) and the plugin's default
subprocess runner caps at 120s — so runs spawn DETACHED with file-redirected
output, and a watcher tails the events file into throttled ◇ lines. run state
lives in $HERMES_HOME/jinn/distill/ (current.json → last-run.json).
"""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
distill = importlib.import_module("plugins.jinn.distill")
jinn_layer = importlib.import_module("plugins.jinn.jinn_layer")


def make_status(**over):
    status = {
        "mode": "local",
        "capturesCount": 4,
        "uncoveredCount": 2,
        "stagedCount": 0,
        "installedCount": 0,
        "distillProvider": "claude",
        "distillModel": "claude-opus-4-8",
        "lastRun": None,
    }
    status.update(over)
    return status


class LayerRunner:
    def __init__(self, status=None):
        self.calls: list[list[str]] = []
        self.status = status if status is not None else make_status()

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        if argv[1:3] == ["distill", "status"]:
            return 0, json.dumps(self.status)
        if argv[1:2] == ["distill"] and "--where" in argv:
            self.status = dict(self.status, mode=argv[argv.index("--where") + 1])
            return 0, json.dumps({"where": self.status["mode"]})
        return 0, "ok"


class SpawnSpy:
    def __init__(self, pid: int = 4242):
        self.pid = pid
        self.calls: list[dict] = []

    def __call__(self, args, stdout_path, stderr_path) -> int:
        self.calls.append({"args": list(args), "stdout": Path(stdout_path), "stderr": Path(stderr_path)})
        Path(stderr_path).parent.mkdir(parents=True, exist_ok=True)
        Path(stderr_path).touch()
        return self.pid


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("JINN_LAYER_CAPTURES_DIR", str(tmp_path / "captures"))
    distill.reset()
    # No real threads in unit tests — the drain step is exercised directly.
    monkeypatch.setattr(distill, "_start_watcher", lambda *a, **k: None)
    yield
    jinn._runner = None


def ev(event: str, **fields) -> str:
    return json.dumps({"v": 1, "event": event, "ts": "2026-07-10T12:00:00.000Z", "runId": "distill-1-aaaa", **fields})


# ── start/refuse/stop lifecycle ──────────────────────────────────────────────


def test_start_run_spawns_detached_with_progress_resume_and_skills_out(monkeypatch):
    spawn = SpawnSpy()
    ok, msg = distill.start_run(spawn=spawn)
    assert ok, msg
    args = spawn.calls[0]["args"]
    assert args[0] == "distill"
    assert "--progress" in args and "ndjson" in args
    assert "--resume" in args and "--json" in args
    out_flag = args[args.index("--out") + 1]
    assert out_flag.endswith("skills"), "installs land where the native skill loader reads"

    current = json.loads((distill.state_dir() / "current.json").read_text())
    assert current["pid"] == 4242
    assert Path(current["eventsPath"]).exists()


def test_second_start_is_refused_while_the_first_is_alive(monkeypatch):
    spawn = SpawnSpy()
    monkeypatch.setattr(distill, "_pid_alive", lambda pid: True)
    ok, _ = distill.start_run(spawn=spawn)
    assert ok
    ok2, msg2 = distill.start_run(spawn=spawn)
    assert not ok2
    assert "already running" in msg2
    assert len(spawn.calls) == 1


def test_stop_run_signals_the_pid_and_archives_as_stopped(monkeypatch):
    spawn = SpawnSpy()
    monkeypatch.setattr(distill, "_pid_alive", lambda pid: True)
    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(distill.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    distill.start_run(spawn=spawn)

    msg = distill.stop_run()
    assert killed and killed[0][0] == 4242
    assert "resume" in msg or "start" in msg
    assert not (distill.state_dir() / "current.json").exists()
    archived = json.loads((distill.state_dir() / "last-run.json").read_text())
    assert archived["outcome"] == "stopped"


# ── event drain → ◇ lines ────────────────────────────────────────────────────


def _drain_setup(monkeypatch, lines: list[str], clock: list[float]):
    spawn = SpawnSpy()
    monkeypatch.setattr(distill, "_pid_alive", lambda pid: True)
    distill.start_run(spawn=spawn)
    events_path = Path(json.loads((distill.state_dir() / "current.json").read_text())["eventsPath"])
    events_path.write_text("\n".join(lines) + "\n")
    printed: list[str] = []
    state = distill._watch_state(sink=printed.append, now_fn=lambda: clock[0])
    return state, printed


def test_drain_maps_events_to_ambient_lines(monkeypatch):
    clock = [1000.0]
    state, printed = _drain_setup(
        monkeypatch,
        [
            ev("run_start", capturesConsidered=4, toDistill=2, distillModel="claude-opus-4-8"),
            "not json — a capture warning shares stderr",
            ev("heartbeat", clusterId="c1", index=1, total=2, elapsedMs=15000),
            ev("cluster_end", clusterId="c1", index=1, total=2, outcome="published", skillName="retry-backoff-patterns"),
        ],
        clock,
    )
    done = distill._drain_events(state)
    assert not done
    assert any("started" in line and "2" in line for line in printed), printed
    assert any('1/2' in line and "retry-backoff-patterns" in line for line in printed), printed
    assert not any("heartbeat" in line.lower() for line in printed), "heartbeats are liveness only"

    # A failed cluster keeps the run going; run_end closes it out.
    clock[0] += 10
    events_path = Path(state["eventsPath"])
    with events_path.open("a") as f:
        f.write(ev("cluster_end", clusterId="c2", index=2, total=2, outcome="error", error="boom") + "\n")
        f.write(ev("run_end", outcome="ok", clusterCount=2, published=["retry-backoff-patterns"], rejectedCount=0, errorCount=1, installed=[]) + "\n")
    done = distill._drain_events(state)
    assert done
    assert any("failed" in line and "2/2" in line for line in printed), printed
    assert any("done" in line and "/jinn distill review" in line for line in printed), printed
    # run_end archives current → last-run.
    assert not (distill.state_dir() / "current.json").exists()
    assert json.loads((distill.state_dir() / "last-run.json").read_text())["outcome"] == "ok"


def test_lines_are_throttled_per_event_type(monkeypatch):
    clock = [1000.0]
    state, printed = _drain_setup(
        monkeypatch,
        [
            ev("cluster_end", clusterId="c1", index=1, total=3, outcome="published", skillName="a"),
            ev("cluster_end", clusterId="c2", index=2, total=3, outcome="published", skillName="b"),
        ],
        clock,
    )
    distill._drain_events(state)
    staged_lines = [l for l in printed if "staged" in l]
    assert len(staged_lines) == 1, "two same-type events inside the throttle window print once"

    clock[0] += 6  # past the 5s window
    events_path = Path(state["eventsPath"])
    with events_path.open("a") as f:
        f.write(ev("cluster_end", clusterId="c3", index=3, total=3, outcome="published", skillName="c") + "\n")
    distill._drain_events(state)
    staged_lines = [l for l in printed if "staged" in l]
    assert len(staged_lines) == 2


def test_dead_pid_without_run_end_archives_as_died(monkeypatch):
    clock = [1000.0]
    state, printed = _drain_setup(monkeypatch, [ev("run_start", toDistill=2, distillModel="m")], clock)
    distill._drain_events(state)
    monkeypatch.setattr(distill, "_pid_alive", lambda pid: False)
    done = distill._drain_events(state)
    assert done
    assert any("died" in line or "resume" in line for line in printed), printed
    assert json.loads((distill.state_dir() / "last-run.json").read_text())["outcome"] == "died"


def test_reattach_with_dead_pid_reports_and_archives(monkeypatch):
    spawn = SpawnSpy()
    monkeypatch.setattr(distill, "_pid_alive", lambda pid: True)
    distill.start_run(spawn=spawn)
    monkeypatch.setattr(distill, "_pid_alive", lambda pid: False)
    printed: list[str] = []
    distill.reattach_watcher(sink=printed.append)
    assert any("died" in line or "resume" in line for line in printed), printed
    assert not (distill.state_dir() / "current.json").exists()


def test_reattach_is_a_no_op_without_a_current_run():
    printed: list[str] = []
    distill.reattach_watcher(sink=printed.append)
    assert printed == []


# ── /jinn distill start|stop command flow ────────────────────────────────────


def _cmd(args: str, runner) -> str:
    jinn._runner = runner
    return jinn._handle_jinn(command_args=("distill " + args).strip(), session_id="s", task_id="t")


def test_start_shows_a_two_step_confirm_with_the_spend_facts():
    out = _cmd("start", LayerRunner(make_status(uncoveredCount=3)))
    assert "3" in out
    assert "claude-opus-4-8" in out
    assert "/jinn distill start confirm" in out
    assert "locally" in out.lower() or "this machine" in out.lower()


def test_start_confirm_records_local_mode_when_unset_then_spawns(monkeypatch):
    runner = LayerRunner(make_status(mode="unset", uncoveredCount=2))
    started: list[dict] = []
    monkeypatch.setattr(distill, "start_run", lambda **kw: (started.append(kw) or (True, "started")))
    out = _cmd("start confirm", runner)
    where_calls = [c for c in runner.calls if "--where" in c]
    assert where_calls and "local" in where_calls[0]
    assert started, "the run spawns after consent is recorded"
    assert "keep working" in out.lower() or "started" in out.lower()


def test_start_with_nothing_uncovered_says_so_and_does_not_spawn(monkeypatch):
    spawned: list = []
    monkeypatch.setattr(distill, "start_run", lambda **kw: spawned.append(kw))
    out = _cmd("start", LayerRunner(make_status(uncoveredCount=0)))
    assert "nothing" in out.lower()
    assert spawned == []


def test_start_while_running_is_refused(monkeypatch):
    monkeypatch.setattr(distill, "is_running", lambda: True)
    out = _cmd("start", LayerRunner(make_status(uncoveredCount=3)))
    assert "already running" in out


def test_stop_without_a_run_says_so():
    out = _cmd("stop", LayerRunner())
    assert "no distillation" in out.lower() or "not running" in out.lower()


def test_start_confirm_upgrades_defer_to_local_and_spawns(monkeypatch):
    # `defer` means "hold captures, run nothing AMBIENTLY" — an explicit
    # two-step start IS the operator choosing local; record it and run.
    runner = LayerRunner(make_status(mode="defer", uncoveredCount=2))
    started: list[dict] = []
    monkeypatch.setattr(distill, "start_run", lambda **kw: (started.append(kw) or (True, "started")))
    out = _cmd("start confirm", runner)
    where_calls = [c for c in runner.calls if "--where" in c]
    assert where_calls and "local" in where_calls[0]
    assert started
    assert "started" in out.lower()
