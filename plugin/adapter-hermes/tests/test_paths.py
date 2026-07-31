"""Home and state-directory derivation (per-Hermes-home isolation, contract 5)."""

from __future__ import annotations

import importlib
from pathlib import Path

paths = importlib.import_module("jinn_plugin.paths")


def test_hermes_home_honours_the_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "profile-a"))
    assert paths.hermes_home() == (tmp_path / "profile-a").resolve()


def test_hermes_home_defaults_under_the_user_home(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert paths.hermes_home() == (tmp_path / ".hermes").resolve()


def test_runtime_home_is_per_hermes_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "worker-1"))
    first = paths.runtime_home()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "worker-2"))
    second = paths.runtime_home()
    assert first != second
    assert first.name == "runtime-home"
    assert first.parent.name == "jinn"


def test_state_dir_sits_under_the_hermes_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert paths.state_dir() == (tmp_path / "jinn").resolve()


def test_plugin_dir_is_the_package_directory():
    assert (paths.plugin_dir() / "plugin.yaml").is_file()


def test_is_installed_plugin_is_false_in_the_repository(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert paths.is_installed_plugin() is False


def test_is_installed_plugin_is_true_under_the_plugins_root(monkeypatch, tmp_path):
    installed = tmp_path / "plugins" / "jinn"
    installed.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(paths, "plugin_dir", lambda: installed)
    assert paths.is_installed_plugin() is True
