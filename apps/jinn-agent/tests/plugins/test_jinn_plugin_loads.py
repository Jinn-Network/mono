"""The jinn plugin must actually LOAD through the real plugin manager.

Regression for the first cold-clone dogfood run (2026-07-03): every other
jinn test imports the plugin modules directly, so the fact that standalone
plugins are opt-in via ``plugins.enabled`` — and the fork shipped with no
enablement — was invisible to the suite. ``/jinn`` was an unknown command
on a fresh install.

Two invariants:
  1. With ``plugins.enabled: [jinn]`` (what ``bin/jinn-agent`` ensures on
     every launch), the real ``PluginManager.discover_and_load`` loads the
     plugin, registers the ``/jinn`` + ``/corpus`` commands and the corpus
     tools.
  2. The entrypoint's config-ensure block produces exactly that enablement
     from a fresh home, is idempotent, and respects an explicit
     ``plugins.disabled`` opt-out.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import yaml

import hermes_cli.plugins as plugins_mod
from hermes_cli.plugins import PluginManager


REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = REPO_ROOT / "bin" / "jinn-agent"


@pytest.fixture()
def isolated_manager(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"enabled": ["jinn"]}}), encoding="utf-8"
    )
    fresh = PluginManager()
    monkeypatch.setattr(plugins_mod, "_plugin_manager", fresh)
    return fresh


def test_jinn_plugin_loads_through_the_real_manager(isolated_manager):
    isolated_manager.discover_and_load()
    loaded = {
        (p.manifest.key or p.manifest.name): p
        for p in isolated_manager._plugins.values()
    }
    jinn = loaded.get("jinn")
    assert jinn is not None, f"jinn plugin not discovered; loaded={list(loaded)}"
    assert jinn.enabled, f"jinn plugin discovered but not enabled: {jinn.error}"
    assert jinn.error is None
    assert "jinn" in jinn.commands_registered
    assert "corpus" in jinn.commands_registered
    assert "corpus_search" in jinn.tools_registered
    assert "corpus_fetch" in jinn.tools_registered


def _ensure_snippet() -> str:
    script = ENTRYPOINT.read_text(encoding="utf-8")
    marker = "<<'PY" + "EOF'\n"
    end = "\nPY" + "EOF"
    assert marker in script, "entrypoint lost its config-ensure block"
    return script.split(marker)[1].split(end)[0]


def _run_ensure(home: Path) -> None:
    os.environ["HERMES_HOME"] = str(home)
    try:
        exec(compile(_ensure_snippet(), "ensure", "exec"), {"__name__": "__main__"})
    except SystemExit:
        pass


def test_entrypoint_enables_jinn_from_a_fresh_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _run_ensure(tmp_path)
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    assert cfg["plugins"]["enabled"] == ["jinn"]
    # Idempotent, and preserves unrelated user config.
    (tmp_path / "config.yaml").write_text(
        yaml.safe_dump({"model": "x", "plugins": {"enabled": ["disk-cleanup", "jinn"]}})
    )
    _run_ensure(tmp_path)
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    assert cfg["model"] == "x"
    assert cfg["plugins"]["enabled"] == ["disk-cleanup", "jinn"]


def test_entrypoint_respects_explicit_disable(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(yaml.safe_dump({"plugins": {"disabled": ["jinn"]}}))
    _run_ensure(tmp_path)
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    assert "jinn" not in (cfg["plugins"].get("enabled") or [])
