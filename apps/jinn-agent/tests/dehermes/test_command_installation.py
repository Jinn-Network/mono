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


def _run(capsys, should_fix=False):
    issues: list[str] = []
    manual_issues: list[str] = []
    fixed = doctor._check_command_installation(issues, manual_issues, should_fix=should_fix)
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
    """~/.local/bin/hermes resolves inside this install's project root but no
    longer matches the venv entry point (simulates a stale link left by a
    recreated venv) — the classic 'wrong-binary hint' leak scenario, and the
    only wrong-target shape doctor is allowed to offer --fix for."""
    cmd_link = fake_venv["cmd_link"]
    cmd_link.parent.mkdir(parents=True, exist_ok=True)
    stale_target = fake_venv["venv_bin"].parent.parent.parent / "old-venv" / "bin" / "hermes"
    stale_target.parent.mkdir(parents=True)
    stale_target.write_text("#!/bin/sh\n")
    cmd_link.symlink_to(stale_target)

    issues, manual_issues, fixed, out = _run(capsys)

    assert fixed == 0
    assert len(issues) == 1
    assert "Broken symlink at ~/.local/bin/hermes" in issues[0]
    assert "run 'jinn-agent doctor --fix'" in issues[0]
    assert "run 'hermes doctor --fix'" not in issues[0]
    assert_no_upstream_brand(issues[0])


def test_foreign_target_symlink_is_reported_not_claimed(fake_venv, capsys):
    """~/.local/bin/hermes resolves outside this install's project root
    (e.g. a coexisting stock hermes install on a dual-install machine).
    Doctor must NOT advertise --fix for it — --fix would refuse — and must
    surface it as a manual issue instead."""
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
    assert issues == []
    assert len(manual_issues) == 1
    assert "doctor --fix" not in manual_issues[0]
    assert "another install" in out
    assert_no_upstream_brand(manual_issues[0])


def test_fix_refuses_to_repoint_foreign_target_symlink(fake_venv, capsys):
    """The dual-install hazard itself: with --fix, doctor must leave a
    foreign-target ~/.local/bin/hermes exactly as it found it — unlinking
    and repointing it would hijack the user's stock hermes command."""
    cmd_link = fake_venv["cmd_link"]
    cmd_link.parent.mkdir(parents=True, exist_ok=True)
    foreign_dir = fake_venv["home"] / "stock-hermes" / "venv" / "bin"
    foreign_dir.mkdir(parents=True)
    foreign_target = foreign_dir / "hermes"
    foreign_target.write_text("#!/bin/sh\n")
    foreign_target.chmod(0o755)
    cmd_link.symlink_to(foreign_target)

    issues, manual_issues, fixed, out = _run(capsys, should_fix=True)

    assert fixed == 0
    assert cmd_link.is_symlink()
    assert cmd_link.resolve() == foreign_target.resolve()
    assert "Fixed symlink" not in out
    assert len(manual_issues) == 1


def test_fix_repairs_stale_link_into_own_install(fake_venv, capsys):
    """With --fix, a wrong-target link that still resolves inside this
    install's project root IS ours to repair — repoint it at the venv
    entry point."""
    cmd_link = fake_venv["cmd_link"]
    cmd_link.parent.mkdir(parents=True, exist_ok=True)
    stale_target = fake_venv["venv_bin"].parent.parent.parent / "old-venv" / "bin" / "hermes"
    stale_target.parent.mkdir(parents=True)
    stale_target.write_text("#!/bin/sh\n")
    cmd_link.symlink_to(stale_target)

    issues, manual_issues, fixed, out = _run(capsys, should_fix=True)

    assert fixed == 1
    assert cmd_link.is_symlink()
    assert cmd_link.resolve() == fake_venv["venv_bin"].resolve()
    assert "Fixed symlink" in out


def test_fix_creates_missing_symlink(fake_venv, capsys):
    """Control: creating ~/.local/bin/hermes where nothing exists stays
    allowed under --fix — there is no foreign launcher to hijack."""
    assert not fake_venv["cmd_link"].exists()

    issues, manual_issues, fixed, out = _run(capsys, should_fix=True)

    assert fixed == 1
    assert fake_venv["cmd_link"].resolve() == fake_venv["venv_bin"].resolve()


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
