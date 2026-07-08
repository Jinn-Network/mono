"""Regression tests for hermes_cli.uninstall.remove_wrapper_script.

Wrong-binary follow-up to the de-hermes sweep: a jinn-agent install's own
command is the ``jinn-agent`` symlink setup.sh links into ``~/.local/bin``
(target: ``<checkout>/bin/jinn-agent``). The uninstaller previously only
looked for wrappers named ``hermes``, so the fork's own command was never
removed.

These tests never run the uninstall subcommand itself (it self-deletes the
checkout); they exercise the wrapper-removal helper against temp paths only.
"""

from pathlib import Path

from hermes_cli import uninstall


def test_candidates_include_jinn_agent_names():
    paths = [str(p) for p in uninstall._wrapper_script_candidates()]
    assert str(Path.home() / ".local" / "bin" / "jinn-agent") in paths
    assert "/usr/local/bin/jinn-agent" in paths
    # Upstream-named wrappers stay covered too.
    assert str(Path.home() / ".local" / "bin" / "hermes") in paths
    assert "/usr/local/bin/hermes" in paths


def _patch_candidates(monkeypatch, paths):
    monkeypatch.setattr(uninstall, "_wrapper_script_candidates", lambda: list(paths))


def test_removes_jinn_agent_symlink(tmp_path, monkeypatch):
    checkout_bin = tmp_path / "repo" / "bin" / "jinn-agent"
    checkout_bin.parent.mkdir(parents=True)
    checkout_bin.write_text("#!/bin/sh\n")
    link = tmp_path / "bin" / "jinn-agent"
    link.parent.mkdir()
    link.symlink_to(checkout_bin)

    _patch_candidates(monkeypatch, [link])
    removed = uninstall.remove_wrapper_script()

    assert removed == [link]
    assert not link.is_symlink()
    assert checkout_bin.exists()  # only the link goes, never the target


def test_removes_dangling_jinn_agent_symlink(tmp_path, monkeypatch):
    # If the checkout is already gone, the dead link must still be cleaned up.
    link = tmp_path / "bin" / "jinn-agent"
    link.parent.mkdir()
    link.symlink_to(tmp_path / "gone" / "bin" / "jinn-agent")

    _patch_candidates(monkeypatch, [link])
    removed = uninstall.remove_wrapper_script()

    assert removed == [link]
    assert not link.is_symlink()


def test_leaves_symlink_pointing_elsewhere(tmp_path, monkeypatch):
    target = tmp_path / "somewhere" / "other-tool"
    target.parent.mkdir()
    target.write_text("#!/bin/sh\n")
    link = tmp_path / "bin" / "jinn-agent"
    link.parent.mkdir()
    link.symlink_to(target)

    _patch_candidates(monkeypatch, [link])
    removed = uninstall.remove_wrapper_script()

    assert removed == []
    assert link.is_symlink()


def test_removes_legacy_hermes_wrapper_file(tmp_path, monkeypatch):
    wrapper = tmp_path / "bin" / "hermes"
    wrapper.parent.mkdir()
    wrapper.write_text('#!/bin/sh\nexec python -m hermes_cli.main "$@"\n')

    _patch_candidates(monkeypatch, [wrapper])
    removed = uninstall.remove_wrapper_script()

    assert removed == [wrapper]
    assert not wrapper.exists()


def test_leaves_unrelated_file(tmp_path, monkeypatch):
    wrapper = tmp_path / "bin" / "hermes"
    wrapper.parent.mkdir()
    wrapper.write_text("#!/bin/sh\necho not ours\n")

    _patch_candidates(monkeypatch, [wrapper])
    removed = uninstall.remove_wrapper_script()

    assert removed == []
    assert wrapper.exists()
