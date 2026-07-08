"""Deterministic coverage for doctor's command-installation symlink checks.

The acceptance gate's subprocess-based tests (test_status_version.py's
``test_doctor_is_hermes_free``) only exercise whatever
``~/.local/bin/hermes`` happens to be on the machine running the tests —
green or red depending on the developer's real symlink state. That's an
environment-dependent gate for exactly the branches (broken/missing/foreign
symlink) that produce the conditional issue strings this task fixes
(``hermes_cli/doctor.py``'s "run 'hermes doctor --fix'" hints, now
"run 'jinn-agent doctor --fix'").

These tests unit-call ``hermes_cli.doctor._check_command_installation``
directly (the seam extracted from ``run_doctor`` for this purpose) with a
fake venv layout and a monkeypatched ``Path.home()``, driving each symlink
state explicitly — so the leak class can never again hide behind machine
state.
"""
import os

import pytest

from hermes_cli import doctor
from tests.dehermes.brandcheck import assert_no_upstream_brand


@pytest.fixture
def fake_venv(tmp_path, monkeypatch):
    """A fake PROJECT_ROOT with a real venv/bin/hermes entry point, and a
    fake $HOME (so Path.home() / ".local" / "bin" is fully controlled).
    """
    project_root = tmp_path / "project"
    venv_bin_dir = project_root / "venv" / "bin"
    venv_bin_dir.mkdir(parents=True)
    venv_bin = venv_bin_dir / "hermes"
    venv_bin.write_text("#!/bin/sh\n")
    venv_bin.chmod(0o755)

    home = tmp_path / "home"
    home.mkdir()

    monkeypatch.setattr(doctor, "PROJECT_ROOT", project_root)
    monkeypatch.setattr(doctor.Path, "home", classmethod(lambda cls: home))
    # Command-link dir resolution also reads PREFIX/TERMUX_VERSION; make sure
    # a developer's real environment doesn't divert us onto the Termux branch.
    monkeypatch.delenv("PREFIX", raising=False)
    monkeypatch.delenv("TERMUX_VERSION", raising=False)

    cmd_link = home / ".local" / "bin" / "hermes"
    return {"venv_bin": venv_bin, "home": home, "cmd_link": cmd_link}


def _run(capsys):
    issues: list[str] = []
    manual_issues: list[str] = []
    fixed = doctor._check_command_installation(issues, manual_issues, should_fix=False)
    out = capsys.readouterr().out
    return issues, manual_issues, fixed, out


def test_missing_symlink_issue_is_jinn_agent_free(fake_venv, capsys):
    """No ~/.local/bin/hermes at all: doctor must report it, and the fix
    hint must name jinn-agent, not hermes."""
    assert not fake_venv["cmd_link"].exists()

    issues, manual_issues, fixed, out = _run(capsys)

    assert fixed == 0
    assert len(issues) == 1
    assert "Missing ~/.local/bin/hermes symlink" in issues[0]
    assert "run 'jinn-agent doctor --fix'" in issues[0]
    assert "run 'hermes doctor --fix'" not in issues[0]
    # Assert on the issue string itself, not raw stdout: stdout also embeds
    # the tmp_path fixture location, which legitimately contains "hermes"
    # (PROJECT_ROOT's own venv/bin/hermes path) outside brandcheck's narrow
    # technical-path patterns — that's a test-fixture artifact, not a leak.
    assert_no_upstream_brand(issues[0])


def test_broken_symlink_issue_is_jinn_agent_free(fake_venv, capsys):
    """~/.local/bin/hermes exists but resolves to a target that no longer
    matches the venv entry point (simulates a stale symlink from another
    install/worktree) — the classic 'wrong-binary hint' leak scenario."""
    cmd_link = fake_venv["cmd_link"]
    cmd_link.parent.mkdir(parents=True, exist_ok=True)
    stale_target = fake_venv["home"] / "stale-hermes-binary"
    stale_target.write_text("#!/bin/sh\n")
    cmd_link.symlink_to(stale_target)

    issues, manual_issues, fixed, out = _run(capsys)

    assert fixed == 0
    assert len(issues) == 1
    assert "Broken symlink at ~/.local/bin/hermes" in issues[0]
    assert "run 'jinn-agent doctor --fix'" in issues[0]
    assert "run 'hermes doctor --fix'" not in issues[0]
    assert_no_upstream_brand(issues[0])


def test_foreign_target_symlink_issue_is_jinn_agent_free(fake_venv, capsys):
    """~/.local/bin/hermes is a symlink to some other real binary entirely
    (foreign target) — distinct from 'broken' (dangling) but the same
    'points to wrong target' code path and issue string."""
    cmd_link = fake_venv["cmd_link"]
    cmd_link.parent.mkdir(parents=True, exist_ok=True)
    foreign_dir = fake_venv["home"] / "other-project" / "venv" / "bin"
    foreign_dir.mkdir(parents=True)
    foreign_target = foreign_dir / "hermes"
    foreign_target.write_text("#!/bin/sh\n")
    foreign_target.chmod(0o755)
    cmd_link.symlink_to(foreign_target)

    issues, manual_issues, fixed, out = _run(capsys)

    assert fixed == 0
    assert len(issues) == 1
    assert "points to wrong target" in out
    assert "run 'jinn-agent doctor --fix'" in issues[0]
    assert "run 'hermes doctor --fix'" not in issues[0]
    assert_no_upstream_brand(issues[0])


def test_correct_symlink_produces_no_issue(fake_venv, capsys):
    """Sanity check / control case: a correctly-pointed symlink reports OK
    and appends no issue at all (guards against the fixture itself being
    broken and always tripping the issue branches)."""
    cmd_link = fake_venv["cmd_link"]
    cmd_link.parent.mkdir(parents=True, exist_ok=True)
    cmd_link.symlink_to(fake_venv["venv_bin"])

    issues, manual_issues, fixed, out = _run(capsys)

    assert fixed == 0
    assert issues == []
    assert "correct target" in out
