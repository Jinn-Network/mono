"""The runtime pin: read, assert without Node, acquire, classify an outage."""

from __future__ import annotations

import importlib
import json
import os
import stat
from pathlib import Path

import pytest

runtime_pin = importlib.import_module("jinn_plugin.runtime_pin")
paths = importlib.import_module("jinn_plugin.paths")


def write_pin(directory: Path, **overrides) -> None:
    document = {
        "package": "@jinn-network/plugin-runtime",
        "version": "0.1.0",
        "bin": "runtime/node_modules/.bin/jinn-plugin-runtime",
    }
    document.update(overrides)
    (directory / "runtime-pin.json").write_text(json.dumps(document), encoding="utf-8")


def install_runtime(directory: Path, version: str = "0.1.0") -> Path:
    package_dir = directory / "runtime" / "node_modules" / "@jinn-network" / "plugin-runtime"
    package_dir.mkdir(parents=True)
    (package_dir / "package.json").write_text(
        json.dumps({"name": "@jinn-network/plugin-runtime", "version": version}),
        encoding="utf-8",
    )
    bin_dir = directory / "runtime" / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    binary = bin_dir / "jinn-plugin-runtime"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
    session_binary = bin_dir / "jinn-plugin-runtime-session"
    session_binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    session_binary.chmod(session_binary.stat().st_mode | stat.S_IXUSR)
    return binary


def test_shipped_pin_is_well_formed():
    pin = runtime_pin.read_pin()
    assert pin.package == runtime_pin.RUNTIME_PACKAGE
    assert pin.bin_path == "runtime/node_modules/.bin/jinn-plugin-runtime"


@pytest.mark.parametrize(
    "overrides",
    [
        {"package": "@jinn-network/jinn-layer"},
        {"version": "^0.1.0"},
        {"version": "latest"},
        {"bin": "/usr/local/bin/jinn-plugin-runtime"},
        {"bin": "../escape/jinn-plugin-runtime"},
        {"bin": ""},
    ],
)
def test_a_malformed_pin_is_refused(tmp_path, overrides):
    write_pin(tmp_path, **overrides)
    with pytest.raises(runtime_pin.RuntimePinError):
        runtime_pin.read_pin(tmp_path)


def test_resolution_asserts_the_installed_manifest_without_running_node(tmp_path):
    write_pin(tmp_path)
    binary = install_runtime(tmp_path)
    resolution = runtime_pin.resolve(tmp_path)
    assert resolution.source == "pinned"
    assert resolution.argv == (str(binary),)
    assert "0.1.0" in resolution.detail


def test_a_version_mismatch_in_the_installed_manifest_is_refused(tmp_path):
    write_pin(tmp_path)
    install_runtime(tmp_path, version="0.0.9")
    with pytest.raises(runtime_pin.RuntimePinError, match="version mismatch"):
        runtime_pin.resolve(tmp_path)


def test_a_non_executable_artifact_is_refused(tmp_path):
    write_pin(tmp_path)
    binary = install_runtime(tmp_path)
    binary.chmod(0o600)
    with pytest.raises(runtime_pin.RuntimePinError, match="not executable"):
        runtime_pin.resolve(tmp_path)


def test_the_env_override_is_a_development_branch(tmp_path, monkeypatch):
    write_pin(tmp_path)
    monkeypatch.setenv("JINN_PLUGIN_RUNTIME_BIN", "/opt/dev/jinn-plugin-runtime")
    resolution = runtime_pin.resolve(tmp_path)
    assert resolution.source == "env"
    assert "development override" in resolution.detail


def test_ensure_installs_the_exact_pin(tmp_path, monkeypatch):
    write_pin(tmp_path)
    monkeypatch.delenv("JINN_PLUGIN_RUNTIME_BIN", raising=False)
    seen = {}

    def installer(argv, cwd):
        seen["argv"] = argv
        install_runtime(tmp_path)
        return 0, "", ""

    monkeypatch.setattr(paths, "is_installed_plugin", lambda: True)
    resolution = runtime_pin.ensure(tmp_path, installer=installer)
    assert resolution.source == "pinned"
    assert "--save-exact" in seen["argv"]
    assert "@jinn-network/plugin-runtime@0.1.0" in seen["argv"]


def test_ensure_removes_superseded_runtime_residue(tmp_path, monkeypatch):
    write_pin(tmp_path)
    install_runtime(tmp_path, version="0.0.9")
    stale = tmp_path / "runtime" / "node_modules" / "@jinn-network" / "plugin-runtime"
    assert stale.is_dir()

    def installer(argv, cwd):
        assert not (tmp_path / "runtime" / "node_modules").exists()
        install_runtime(tmp_path)
        return 0, "", ""

    monkeypatch.setattr(paths, "is_installed_plugin", lambda: True)
    resolution = runtime_pin.ensure(tmp_path, installer=installer)
    assert resolution.pin.version == "0.1.0"


def test_ensure_refuses_a_symlinked_runtime_prefix(tmp_path, monkeypatch):
    write_pin(tmp_path)
    (tmp_path / "elsewhere").mkdir()
    (tmp_path / "runtime").symlink_to(tmp_path / "elsewhere")
    monkeypatch.setattr(paths, "is_installed_plugin", lambda: True)
    with pytest.raises(runtime_pin.RuntimePinError, match="symlink"):
        runtime_pin.ensure(tmp_path, installer=lambda argv, cwd: (0, "", ""))


@pytest.mark.parametrize(
    "stderr",
    [
        "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/...",
        "npm error notarget No matching version found for @jinn-network/plugin-runtime@0.1.0.",
        "npm error code ETARGET",
    ],
)
def test_an_unsatisfiable_pin_is_a_channel_outage(tmp_path, stderr, monkeypatch):
    write_pin(tmp_path)
    monkeypatch.setattr(paths, "is_installed_plugin", lambda: True)
    with pytest.raises(runtime_pin.ChannelOutageError):
        runtime_pin.ensure(tmp_path, installer=lambda argv, cwd: (1, "", stderr))


def test_a_network_failure_stays_an_ordinary_pin_error(tmp_path, monkeypatch):
    write_pin(tmp_path)
    monkeypatch.setattr(paths, "is_installed_plugin", lambda: True)
    with pytest.raises(runtime_pin.RuntimePinError) as caught:
        runtime_pin.ensure(
            tmp_path,
            installer=lambda argv, cwd: (1, "", "npm error network request to registry timed out"),
        )
    assert not isinstance(caught.value, runtime_pin.ChannelOutageError)


def test_missing_npm_is_named_precisely(tmp_path, monkeypatch):
    write_pin(tmp_path)
    monkeypatch.setattr(runtime_pin.shutil, "which", lambda name: None)
    monkeypatch.setattr(paths, "is_installed_plugin", lambda: True)
    with pytest.raises(runtime_pin.RuntimePinError, match="npm is not on PATH"):
        runtime_pin.ensure(tmp_path, installer=lambda argv, cwd: (0, "", ""))


def test_ensure_refuses_acquisition_in_a_repository_checkout(tmp_path, monkeypatch):
    write_pin(tmp_path)
    monkeypatch.delenv("JINN_PLUGIN_RUNTIME_BIN", raising=False)
    monkeypatch.setattr(paths, "is_installed_plugin", lambda: False)
    with pytest.raises(runtime_pin.RuntimePinError, match="refusing"):
        runtime_pin.ensure(tmp_path, installer=lambda argv, cwd: (0, "", ""))
