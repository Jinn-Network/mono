"""/jinn skills install — shells to the layer (mono #1345, thin-fork boundary).

The acceptance criteria: install() no longer parses envelopes or verifies
hashes itself — it shells to `jinn-layer skills install <ref> --json`, which
does the extraction + sha256 verification + SKILL.md write, and only drops
the `.jinn-ref` marker into the dir the layer reports back. Declined consent
does NOT block install (consuming is always allowed — consent gates
contributing only); uninstall never touches skills the user made themselves.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

jinn = importlib.import_module("plugins.jinn")
consent = importlib.import_module("plugins.jinn.consent")
skills_install = importlib.import_module("plugins.jinn.skills_install")

REF = "bafySeedTdd"


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    yield tmp_path


def test_install_shells_to_layer_and_drops_marker(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    skills_root = tmp_path / "skills"

    def fake_runner(argv):
        # argv == ["jinn-layer", "skills", "install", "<ref>", "--json"]
        assert argv[1:4] == ["skills", "install", "abc123"]
        assert "--json" in argv
        target = skills_root / "flaky-retry"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("# skill\n")
        return 0, json.dumps({"dir": str(target), "name": "flaky-retry",
                              "shape": "package", "files": [], "provenance": {}})

    path = skills_install.install("abc123", runner=fake_runner)
    installed = Path(path)
    assert installed.name == "SKILL.md"
    assert (installed.parent / ".jinn-ref").exists()
    ref = json.loads((installed.parent / ".jinn-ref").read_text())["ref"]
    assert ref == "abc123"


def test_install_raises_on_layer_failure(tmp_path):
    def fake_runner(argv):
        return 1, "sha256 mismatch — refusing to install"

    with pytest.raises(ValueError, match="skills install failed"):
        skills_install.install(REF, runner=fake_runner)


def test_install_raises_on_unreadable_result(tmp_path):
    def fake_runner(argv):
        return 0, "not json"

    with pytest.raises(ValueError, match="unreadable skills install result"):
        skills_install.install(REF, runner=fake_runner)


def test_declined_consent_does_not_block_install(tmp_path):
    # Consuming is always allowed — consent gates contributing only.
    consent.save_state(consent.DECLINED)
    skills_root = tmp_path / "skills"

    def fake_runner(argv):
        target = skills_root / "test-driven-development"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("# TDD\n")
        return 0, json.dumps({"dir": str(target), "name": "test-driven-development",
                              "shape": "package", "files": [], "provenance": {}})

    jinn._runner = fake_runner
    try:
        out = jinn._handle_jinn(command_args=f"skills install {REF}")
    finally:
        jinn._runner = None
    assert "installed" in out
    assert (tmp_path / "skills" / "test-driven-development" / "SKILL.md").exists()


def test_uninstall_refuses_unmarked(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    d = tmp_path / "skills" / "mine"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("# mine\n")  # no .jinn-ref marker
    try:
        skills_install.uninstall("mine")
        assert False, "should have refused"
    except ValueError as exc:
        assert "marker" in str(exc)


def test_list_and_uninstall_only_touch_jinn_installed(tmp_path):
    # A skill the user made themselves — no marker.
    user_skill = tmp_path / "skills" / "my-own-skill"
    user_skill.mkdir(parents=True)
    (user_skill / "SKILL.md").write_text("# mine\n")

    skills_root = tmp_path / "skills"

    def fake_runner(argv):
        target = skills_root / "test-driven-development"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("# TDD\n")
        return 0, json.dumps({"dir": str(target), "name": "test-driven-development",
                              "shape": "package", "files": [], "provenance": {}})

    skills_install.install(REF, runner=fake_runner)

    listed = skills_install.list_installed()
    assert [row["slug"] for row in listed] == ["test-driven-development"]

    with pytest.raises(ValueError, match="refusing"):
        skills_install.uninstall("my-own-skill")
    assert user_skill.exists()

    skills_install.uninstall("test-driven-development")
    assert not (tmp_path / "skills" / "test-driven-development").exists()
