"""/jinn distill — splash, status hub, where setter (mono #1538).

First-run detection is facts-over-flags: the FACT is `mode == "unset"` from
`distill status`; the only stored flag is `splash_shown`. All handlers return
stateless strings — no blocking input in the TUI.
"""

from __future__ import annotations

import importlib
import json

import pytest

jinn = importlib.import_module("plugins.jinn")
capture_buffer = importlib.import_module("plugins.jinn.capture_buffer")
distill = importlib.import_module("plugins.jinn.distill")


def make_status(**over):
    status = {
        "mode": "unset",
        "capturesCount": 3,
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
    """Answers distill status/--where; records every call."""

    def __init__(self, status=None, status_code: int = 0):
        self.calls: list[list[str]] = []
        self.status = status if status is not None else make_status()
        self.status_code = status_code

    def __call__(self, argv: list[str]) -> tuple[int, str]:
        self.calls.append(argv)
        if argv[1:3] == ["distill", "status"]:
            if self.status_code != 0:
                return self.status_code, "unknown distill subcommand"
            return 0, json.dumps(self.status)
        if argv[1:2] == ["distill"] and "--where" in argv:
            mode = argv[argv.index("--where") + 1]
            self.status = dict(self.status, mode=mode)
            return 0, json.dumps({"where": mode})
        return 0, "ok"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("JINN_LAYER_CAPTURES_DIR", str(tmp_path / "captures"))
    capture_buffer.reset()
    distill.reset()
    yield
    jinn._runner = None


def _distill(args: str = "") -> str:
    return jinn._handle_jinn(command_args=("distill " + args).strip(), session_id="s1", task_id="t1")


def test_first_run_shows_the_splash_and_marks_it_seen():
    jinn._runner = LayerRunner(make_status(mode="unset", capturesCount=3))
    out = _distill()
    assert "distill" in out.lower()
    assert "on this machine" in out or "locally" in out.lower()
    assert "claude-opus-4-8" in out, "the resolved distiller model is shown (display only, #1496)"
    assert "3" in out, "current reserved-capture count"
    assert "/jinn distill start" in out
    assert distill.load_ux_flags()["splash_shown"] is True


def test_second_call_shows_the_status_hub_not_the_splash():
    jinn._runner = LayerRunner(make_status(mode="unset"))
    first = _distill()
    second = _distill()
    assert first != second
    assert "mode" in second.lower()


def test_hub_reflects_the_status_read():
    distill.mark_ux_flag("splash_shown")
    jinn._runner = LayerRunner(
        make_status(
            mode="local",
            capturesCount=7,
            uncoveredCount=4,
            stagedCount=2,
            installedCount=1,
            lastRun={
                "startedAt": "2026-07-10T12:00:00.000Z",
                "outcome": "ok",
                "published": ["retry-backoff-patterns"],
                "installed": [],
            },
        )
    )
    out = _distill()
    assert "local" in out
    assert "4" in out and "7" in out, "uncovered/total captures"
    assert "2 staged" in out or "staged      2" in out.replace("\n", " ") or "staged 2" in out
    assert "/jinn distill review" in out
    assert "ok" in out


def test_where_sets_the_mode_via_the_layer_and_refreshes_the_cache():
    runner = LayerRunner(make_status(mode="unset"))
    jinn._runner = runner
    out = _distill("where defer")
    where_calls = [c for c in runner.calls if "--where" in c]
    assert where_calls and where_calls[0][1:] == ["distill", "--where", "defer", "--json"]
    assert "defer" in out
    # The cache follows: gating now sees the recorded mode without a new process-wide stale value.
    assert distill.cached_mode(runner) == "defer"


def test_where_off_mentions_captures_stop_being_reserved():
    jinn._runner = LayerRunner(make_status(mode="local"))
    out = _distill("where off")
    assert "reserv" in out.lower() or "captures" in out.lower()


def test_where_rejects_unknown_modes_without_calling_the_layer():
    runner = LayerRunner()
    jinn._runner = runner
    out = _distill("where sideways")
    assert "local" in out and "defer" in out and "off" in out, "usage names the three modes"
    assert [c for c in runner.calls if "--where" in c] == []


def test_layer_without_distill_verbs_points_at_the_canary_update():
    jinn._runner = LayerRunner(status_code=2)
    out = _distill()
    assert "@canary" in out or "update" in out.lower()


def test_handlers_never_call_blocking_input(monkeypatch):
    def boom(*a, **k):  # pragma: no cover - the assertion is that it is never hit
        raise AssertionError("input() must never run in the TUI path")

    monkeypatch.setattr("builtins.input", boom)
    jinn._runner = LayerRunner()
    _distill()
    _distill("where defer")


def test_jinn_help_mentions_the_distill_family():
    assert "/jinn distill" in jinn._JINN_HELP
