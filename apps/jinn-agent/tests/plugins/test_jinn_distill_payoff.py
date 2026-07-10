"""Payoff surface + discoverability (mono #1550, #1551).

The join: $HERMES_HOME/skills/.usage.json (upstream sidecar, keyed by skill
NAME) × .jinn-ref markers carrying a `local-distill:` ref. Sessions diff
usage between start and end; each used distilled skill emits one ambient
◇ line (cap 3). The invitation shows once, after the first install.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
distill = importlib.import_module("plugins.jinn.distill")
skills_install = importlib.import_module("plugins.jinn.skills_install")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    distill.reset()
    yield
    jinn._runner = None


def _install_distilled(name: str, provenance_count: int = 2, use_count: int = 0) -> None:
    d = skills_install.skills_dir() / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"# {name}\n")
    (d / ".jinn-ref").write_text(
        json.dumps({"ref": f"local-distill:{name}", "provenance": [], "provenance_count": provenance_count}) + "\n"
    )
    _set_usage(name, use_count)


def _set_usage(name: str, use_count: int) -> None:
    usage_path = skills_install.skills_dir() / ".usage.json"
    usage = json.loads(usage_path.read_text()) if usage_path.exists() else {}
    usage[name] = {"use_count": use_count, "last_used_at": f"2026-07-10T12:00:0{use_count}.000Z"}
    usage_path.parent.mkdir(parents=True, exist_ok=True)
    usage_path.write_text(json.dumps(usage))


def test_used_distilled_skill_emits_one_payoff_line():
    _install_distilled("retry-backoff-patterns", provenance_count=2, use_count=1)
    snapshot = distill.snapshot_usage()
    _set_usage("retry-backoff-patterns", 2)
    lines = distill.payoff_lines(snapshot)
    assert len(lines) == 1
    assert "retry-backoff-patterns" in lines[0]
    assert "2" in lines[0], "how many of the operator's captures it came from"
    assert lines[0].startswith("◇ skill used")


def test_no_usage_delta_means_silence():
    _install_distilled("retry-backoff-patterns", use_count=3)
    snapshot = distill.snapshot_usage()
    assert distill.payoff_lines(snapshot) == []


def test_non_distilled_skills_are_ignored(tmp_path):
    # A corpus-installed skill (different ref scheme) and a user skill (no marker).
    d = skills_install.skills_dir() / "corpus-skill"
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text("# corpus-skill\n")
    (d / ".jinn-ref").write_text(json.dumps({"ref": "bafy-corpus-ref"}) + "\n")
    u = skills_install.skills_dir() / "user-skill"
    u.mkdir(parents=True, exist_ok=True)
    (u / "SKILL.md").write_text("# user-skill\n")
    snapshot = distill.snapshot_usage()
    _set_usage("corpus-skill", 5)
    _set_usage("user-skill", 5)
    assert distill.payoff_lines(snapshot) == []


def test_payoff_lines_cap_at_three():
    for i in range(5):
        _install_distilled(f"skill-{i}", use_count=0)
    snapshot = distill.snapshot_usage()
    for i in range(5):
        _set_usage(f"skill-{i}", 1)
    assert len(distill.payoff_lines(snapshot)) == 3


def test_session_end_prints_payoff_lines(monkeypatch, capsys):
    # No capture path in play: mode off, consent unset — the payoff lines
    # print regardless (usage is the harness's own telemetry).
    jinn._runner = lambda argv: (0, json.dumps({"mode": "off"})) if argv[1:3] == ["distill", "status"] else (0, "ok")
    _install_distilled("retry-backoff-patterns", provenance_count=2, use_count=0)
    jinn._on_session_start(session_id="s1")
    _set_usage("retry-backoff-patterns", 1)
    jinn._on_session_end(session_id="s1", task_id="t1", completed=True, interrupted=False)
    err = capsys.readouterr().err
    assert "◇ skill used" in err
    assert "retry-backoff-patterns" in err


def test_invitation_shows_once_after_first_install():
    class InstallRunner:
        def __call__(self, argv):
            if argv[1:3] == ["distill", "staged"]:
                return 0, json.dumps([{"name": "s1", "description": "d", "provenance": ["local-capture:a"]}])
            if argv[1:3] == ["distill", "install"]:
                out_dir = Path(argv[argv.index("--out") + 1])
                (out_dir / "s1").mkdir(parents=True, exist_ok=True)
                (out_dir / "s1" / "SKILL.md").write_text("# s1\n")
                return 0, json.dumps({"installed": [{"name": "s1", "path": str(out_dir / "s1" / "SKILL.md")}]})
            return 0, "ok"

    jinn._runner = InstallRunner()
    first = jinn._handle_jinn(command_args="distill install all", session_id="s", task_id="t")
    assert "try" in first.lower(), "first install invites a similar task"
    second = jinn._handle_jinn(command_args="distill install all", session_id="s", task_id="t")
    assert "try" not in second.lower(), "the invitation is one-time"


# ── Discoverability (#1551) ──────────────────────────────────────────────────


def test_distill_skills_view_shows_usage():
    _install_distilled("retry-backoff-patterns", provenance_count=2, use_count=4)

    class StatusRunner:
        def __call__(self, argv):
            if argv[1:3] == ["distill", "status"]:
                return 0, json.dumps({"mode": "local", "stagedCount": 1})
            return 0, "ok"

    jinn._runner = StatusRunner()
    out = jinn._handle_jinn(command_args="distill skills", session_id="s", task_id="t")
    assert "retry-backoff-patterns" in out
    assert "4" in out, "use count is shown"
    assert "1 staged" in out or "staged      1" in out.replace("\n", " ") or "staged 1" in out


def test_jinn_status_includes_a_distill_line():
    class StatusRunner:
        def __call__(self, argv):
            if argv[1:3] == ["distill", "status"]:
                return 0, json.dumps({"mode": "defer", "uncoveredCount": 3, "capturesCount": 5, "stagedCount": 0, "installedCount": 0})
            return 0, "ok"

    jinn._runner = StatusRunner()
    out = jinn._handle_jinn(command_args="status", session_id="s", task_id="t")
    assert "distill" in out.lower()


def test_tips_mention_distill():
    tips = importlib.import_module("hermes_cli.tips")
    assert any("/jinn distill" in tip for tip in tips._JINN_TIPS)
