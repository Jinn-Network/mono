"""Functional wrong-binary regressions left by the de-hermes command-hint sweep.

The string sweep rewrote what the CLI *says*; these guard what it *executes*
and *probes*. On a jinn-agent install, a plain ``hermes`` on PATH resolves to
a stock upstream hermes-agent install, so code paths that resolve or probe
``hermes`` act on the wrong binary:

- ``_ensure_fhs_path_guard`` (update flow) probed ``command -v hermes`` — a
  stock install satisfying the probe skipped the PATH repair while
  ``jinn-agent`` stayed unreachable.
- The profile alias display strings advertised ``hermes -p <name>`` for
  wrappers that now exec the jinn-agent binary.

The wrapper-script and /restart resolver fixes in the same class are covered
next to their units (tests/hermes_cli/test_profiles.py,
tests/hermes_cli/test_uninstall_wrapper.py, tests/gateway/test_update_command.py).
"""

import os
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]


def _arm_guard(monkeypatch, main_mod, fhs_link):
    """Get _ensure_fhs_path_guard past its linux/root/link gates."""
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(os, "geteuid", lambda: 0, raising=False)
    monkeypatch.setattr(main_mod, "_FHS_COMMAND_LINK", fhs_link)


def test_fhs_path_guard_probes_jinn_agent(tmp_path, monkeypatch):
    from hermes_cli import main as main_mod

    fhs_link = tmp_path / "jinn-agent"
    fhs_link.write_text("#!/bin/sh\n")
    _arm_guard(monkeypatch, main_mod, fhs_link)

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)

        class _Result:
            returncode = 0  # resolves → guard stops after the probe

        return _Result()

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)
    main_mod._ensure_fhs_path_guard()

    assert len(calls) == 1
    probe = calls[0]
    assert probe[-1] == "command -v jinn-agent"


def test_fhs_path_guard_noops_without_jinn_agent_link(tmp_path, monkeypatch):
    # A stock /usr/local/bin/hermes link must not arm the guard: the link
    # check is against the jinn-agent name only.
    from hermes_cli import main as main_mod

    _arm_guard(monkeypatch, main_mod, tmp_path / "jinn-agent")  # does not exist

    def fail_run(cmd, **kwargs):
        raise AssertionError(f"guard probed despite missing jinn-agent link: {cmd}")

    monkeypatch.setattr(main_mod.subprocess, "run", fail_run)
    main_mod._ensure_fhs_path_guard()  # returns before any probe


def test_no_command_v_hermes_probe_in_main():
    src = (_REPO / "hermes_cli" / "main.py").read_text(encoding="utf-8")
    assert "command -v hermes" not in src


def test_alias_display_strings_point_at_jinn_agent():
    # `hermes -p` escapes the COMMAND_HINT scanner (`-p` is a flag, not a
    # subcommand), so pin the alias display strings explicitly.
    src = (_REPO / "hermes_cli" / "main.py").read_text(encoding="utf-8")
    assert "→ hermes -p" not in src
    # backup.py's restore flow prints a follow-up command for the wrappers
    # create_wrapper_script just rewrote — it must name the same binary.
    backup_src = (_REPO / "hermes_cli" / "backup.py").read_text(encoding="utf-8")
    assert 'hermes -p {pname}' not in backup_src
