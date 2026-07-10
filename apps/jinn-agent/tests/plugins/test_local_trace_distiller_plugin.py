"""Bundled local-trace-distiller plugin wiring."""

from __future__ import annotations

import yaml

import hermes_cli.plugins as plugins_mod
from hermes_cli.plugins import PluginManager


def test_local_trace_distiller_loads_and_registers_distill(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"enabled": ["local-trace-distiller"]}}),
        encoding="utf-8",
    )

    fresh = PluginManager()
    monkeypatch.setattr(plugins_mod, "_plugin_manager", fresh)

    fresh.discover_and_load()

    loaded = {
        (p.manifest.key or p.manifest.name): p
        for p in fresh._plugins.values()
    }
    plugin = loaded.get("local-trace-distiller")
    assert plugin is not None, f"loaded plugins: {list(loaded)}"
    assert plugin.enabled, plugin.error
    assert "distill" in plugin.commands_registered

    handler = fresh._plugin_commands["distill"]["handler"]
    result = handler("all")
    assert result["action"] == "agent_turn"
    assert "distill_trace_cluster" in result["prompt"]
    assert "session_search" not in result["prompt"]
    assert "recent local sessions" in result["message"].lower()


def test_jinn_agent_entrypoint_enables_distiller_from_a_fresh_home(tmp_path, monkeypatch):
    from tests.plugins.test_jinn_plugin_loads import _run_ensure

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    _run_ensure(tmp_path)

    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    assert cfg["plugins"]["enabled"] == ["jinn", "local-trace-distiller"]
